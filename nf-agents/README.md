# nf-agents

A Claude Code skill that wraps the team-spawning and agent-spawning primitives into five named modes (`standby`, `tasks`, `solo`, `status`, `teardown`), with a pre-flight check that surfaces common misconfigurations before they cause silent failures.

This is the white-labeled, shareable version of a skill I use day-to-day. Examples and references have been generalized so you can drop it into any setup.

## Install

1. Copy the `nf-agents/` folder into `~/.claude/skills/`:

   ```bash
   cp -r nf-agents ~/.claude/skills/
   ```

   The end result should be `~/.claude/skills/nf-agents/SKILL.md`.

2. Verify Claude Code sees it. In a new Claude Code session, type `/nf-agents` and the skill should appear in the slash-command list.

## Required environment

The skill runs four pre-flight checks on every spawn. To make them pass:

1. **`teammateMode` is not `in-process`.** In `~/.claude/settings.json` set `"teammateMode": "tmux"` or `"auto"`.

2. **A split-pane backend is available.** Either launch `claude` from inside a `tmux` session, or launch `claude` from iTerm2 with the `it2` CLI installed (iTerm2 3.6.6+).

3. **A `WorktreeCreate` hook is registered.** This is the hook that bases agent worktrees on your current `HEAD` instead of `origin/<default-branch>`. Without it, merging an agent's PR back into your feature branch can silently revert in-progress work. See the README's "WorktreeCreate hook" section below.

4. **Current working directory is a git repo.** Worktree isolation requires it.

If any check fails, the skill surfaces the gap before the spawn is attempted.

## Recommended companion rules

`nf-agents` works best when the session it runs in has two rules loaded. They live in this folder for convenience:

| Rule | Purpose |
|---|---|
| [`rules/agent-safety.md`](./rules/agent-safety.md) | When to delegate via worktree vs no-isolation vs main session, spawning patterns (parallel, sequential, background, team), integration without switching branches, and incident references that motivated each rule. |
| [`rules/git.md`](./rules/git.md) | Commit format (`<prefix>(<ticket-id>): <description>`), branch naming, multi-account `gh` handling, branch merge rules, branch cleanup, branch case sensitivity. Spawned agents inherit this format so PRs from a team are consistent. |

Drop them into your global rules folder so every session picks them up:

```bash
cp rules/agent-safety.md rules/git.md ~/.claude/rules/
```

Or load them per-project under `<project>/.claude/rules/` if you only want them in specific repos.

Both rules are independent of the skill itself, but the skill's prompt templates assume their conventions. Without them, spawned members write commit messages with no prefix, may push directly to the target branch, or interleave branch switches with monitoring loops in the main session.

## Usage

Type `/nf-agents <mode>` from a Claude Code session, where `<mode>` is one of:

| Mode | When to use |
|---|---|
| `standby` | Spawn a team where each member waits for direction. You drive each member interactively (typing into its pane, or via `SendMessage` from the lead). |
| `tasks` | Spawn a team where each member is briefed up-front with a concrete task. Members execute autonomously and report back when done. |
| `solo` | Single agent, no team, but still inside a worktree so commits and pushes do not touch your live working copy. |
| `status` | Inspect the current team. Lists members, busy/idle state, recent updates. |
| `teardown` | Send a cooperative `shutdown_request` to each member, call `TeamDelete`, surface zombies. |

If you omit the mode, the skill asks you which one you want.

## WorktreeCreate hook

Without this hook, agent worktrees are based on `origin/<default-branch>` (typically `origin/main`), not your current `HEAD`. That makes it easy to merge an agent's PR back into your feature branch and silently revert your in-progress work to stale `main`.

Here is a minimal hook script. Save it as `~/.claude/hooks/worktree-create.sh` and `chmod +x` it:

```bash
#!/usr/bin/env bash
# Rewrite the worktree-create command so agent worktrees base on the parent
# session's current HEAD, not origin/<default-branch>.
set -euo pipefail

SLUG="${1:?missing slug}"
WORKTREE_PATH="${2:?missing path}"
PARENT_HEAD="$(git rev-parse HEAD)"

git worktree add --no-track -b "worktree/${SLUG}" "${WORKTREE_PATH}" "${PARENT_HEAD}"
```

Then in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "WorktreeCreate": "~/.claude/hooks/worktree-create.sh"
  }
}
```

Re-verify the hook still fires after every Claude Code version upgrade. The CLI occasionally changes how hooks are resolved.

## Customizing

The standby and tasks prompt templates live inside `SKILL.md`. Edit them to match your team's conventions:

- Commit format. The default leaves it generic. If you use a prefix-and-ticket-id format, mention it explicitly so spawned members follow it.
- Target branch handling. The default has the agent open PRs back to the parent branch the worktree was based on. If your team uses a different review flow (gating branches, mandatory rebasing), adjust the prompt.
- Reporting protocol. The default has each member call `TaskUpdate(status: "completed")` and `SendMessage` the team lead a one-paragraph summary plus PR url on completion. Keep this, or adapt to whatever messaging surfaces your team checks.

## Why the skill is `disable-model-invocation: true`

The frontmatter sets `disable-model-invocation: true`, which means the skill is user-invoked only. The model will not auto-trigger it from a description match. This is deliberate: spawning a team has real consequences (worktrees created, processes launched) and should be an explicit user action.

If you want auto-trigger behavior, remove that line from the frontmatter.

## Two-part write-up

There is a longer write-up of the design decisions behind this skill at:

- Part 1 (Overview): https://blog.nghia-pham.com/blog/nf-agents-overview/
- Part 2 (Deep-dive): https://blog.nghia-pham.com/blog/nf-agents-deep-dive/

## License

MIT. Use, modify, redistribute. No warranty.

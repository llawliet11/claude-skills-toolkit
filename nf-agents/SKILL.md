---
name: nf-agents
description: "Spawn Claude Code teams or single agents with proper team mode, worktree isolation, and standby/task patterns. Triggers on: '/nf-agents', 'spawn team', 'tao team', 'spawn teammate', 'spawn agent', 'kill team', 'team status'."
disable-model-invocation: true
---

# nf-agents — Agent and Team Spawning Skill

Use this skill when the user wants to spawn Claude Code agents or teams. It encapsulates the verified-working patterns from previous sessions and prevents the common mistakes (spawning standalone agents without team context, missing worktree isolation, manual `tmux split` instead of binary-managed split).

## Required environment

Before any spawn, run this pre-flight check:

```bash
# 1. teammateMode must enable split-pane mode (NOT "in-process")
MODE=$(jq -r '.teammateMode // "auto"' ~/.claude/settings.json)
[ "$MODE" = "in-process" ] && echo "FAIL: set teammateMode to 'tmux' or 'auto' first"

# 2. Split-pane backend available — ONE of these must hold:
#    a. inside tmux session     → tmux split backend
#    b. iTerm2 + it2 CLI ≥ 3.6.6 → iTerm2 native split backend
if [ -n "${TMUX:-}" ]; then
  echo "OK: tmux backend"
elif [ "${TERM_PROGRAM:-}" = "iTerm.app" ] && command -v it2 >/dev/null; then
  echo "OK: iTerm2 backend"
else
  echo "FAIL: no split-pane backend — start tmux OR open iTerm2 with it2 installed"
fi

# 3. WorktreeCreate hook present (so worktrees base on current HEAD)
jq -e '.hooks.WorktreeCreate' ~/.claude/settings.json >/dev/null || \
  echo "WARN: WorktreeCreate hook missing — worktrees will base on origin/<default-branch>"

# 4. Current cwd is a git repo (required for isolation: "worktree")
git rev-parse --git-dir >/dev/null 2>&1 || echo "FAIL: not in a git repo"
```

The setting name `"tmux"` is legacy — it actually means "any split-pane backend"; binary auto-detects whether to use tmux or iTerm2 at runtime. Don't insist on tmux specifically.

If any FAIL, surface the gap to the user before proceeding — don't paper over it.

## Backend choice (tmux vs iTerm2 split) — important

The user **cannot** force a backend via setting. Backend is decided by the environment when `claude` was launched:

| Detected env | Backend chosen |
|---|---|
| `TMUX` env set (claude launched inside a tmux session) | **tmux split-window** in that session |
| `TERM_PROGRAM=iTerm.app` AND `it2` CLI present AND no `TMUX` | **iTerm2 native split** (separate panes in iTerm2) |
| Neither | Spawn fails (or in-process fallback if mode=`auto`) |

### Persistence implications

| Backend | Close terminal → what survives |
|---|---|
| iTerm2 split | All claude PTYs killed → team teardown cascade. **Transcripts** persist on disk (`~/.claude/projects/.../<session-id>.jsonl`) and individual sessions can be resumed via `claude --resume <id>`, but the team registry / SendMessage links are GONE. |
| tmux session | tmux server keeps running detached → all claude processes alive → `tmux attach -t <name>` reconnects exactly where you left off. Survives terminal close, even SSH disconnect. |

### Pre-flight: ask the user about persistence intent

Before spawning, if there's any ambiguity, ask:

> "Backend: bạn muốn `iTerm2 split` (default — gọn, không persist) hay `tmux session` (persist, attach từ máy khác / mobile được)?"

If user picks **iTerm2** and `TMUX` is unset → proceed.
If user picks **tmux** and `TMUX` is unset → tell them to `tmux new -s <name>` first, then re-run claude inside it; abort current spawn.
If user picks **iTerm2** but `TMUX` is set → tell them to detach (`Ctrl-B d`) and run claude outside tmux; abort.

Don't auto-fix the environment — terminal launch context is the user's responsibility.

### Decision matrix (surface this when user asks "which one?")

| Use case | Recommended |
|---|---|
| Daily work, 1 máy, vài giờ | iTerm2 split (default) |
| Cần đóng máy / SSH attach từ phone | tmux session |
| Long-running team (>1 ngày) | tmux session |
| 1 task lẻ, parallel với chat chính, không cần xem live | Standalone Agent (`teammateMode` không matter — bg in-process) |
| Vài task parallel, cần xem live output | Team mode + iTerm2 hoặc tmux |

## Modes

The skill takes a mode as the first arg: `/nf-agents <mode> [...]`. If no mode is given, ask the user which mode to use.

### Mode 1: `standby` — Team with standby teammates (default, recommended)

**When to use:** User has multiple parallel domains/projects but doesn't yet know the exact tasks. They will drive each teammate interactively after spawn (either by typing into the teammate's tmux pane, or by `SendMessage` from the lead).

**What to ask the user (if not in their prompt already):**

1. Team name (suggested: descriptive, kebab-case, e.g. `worker-team`)
2. Teammate names + brief role/domain for each (e.g. `api-worker: handles incoming webhook events`, `feed-worker: handles RSS ingestion`)
3. Target branch for PRs (defaults to current branch)

**Execute:**

1. Call `TeamCreate({team_name, description, agent_type: "team-lead"})`.
2. For each teammate, call:
   ```
   Agent({
     name: "<teammate-name>",
     team_name: "<team-name>",
     subagent_type: "<inferred — usually fullstack-engineer or general-purpose>",
     isolation: "worktree",
     prompt: "<standby brief — see template below>"
   })
   ```

**Standby prompt template** (use verbatim, fill the placeholders):

```
You are '<teammate-name>' in team '<team-name>'.

Role: <one-line role from user>

Standby protocol:
- DO NOT start any code work yet. The user will give you specific tasks
  later — either by typing directly into your tmux pane, or via SendMessage
  from the team lead.
- When you receive a task, work on it inside this worktree. The worktree
  is based on '<target-branch>' HEAD. Auto-commit and auto-push are allowed
  (follow your team's commit-message convention — see the "Reference"
  section at the bottom of this skill for what to bake into this prompt).
  First push must use 'git push -u origin worktree/<slug>' to set upstream.
- When you finish a task, do TWO things:
  1. TaskUpdate(status: "completed") so team-lead UI shows the success badge.
  2. SendMessage(to: "team-lead", message: "<one-paragraph summary + PR url
     if opened>").
- Open PRs against '<target-branch>'. Never auto-merge. Never push to the
  target branch directly.
- When you have nothing to do, stay idle. Don't originate shutdown_request
  unless the user asks you to wind down.

Acknowledge readiness in <=2 lines, then idle.
```

After spawning all teammates, the lead returns to idle, waiting for user direction.

### Mode 2: `tasks` — Team with pre-briefed autonomous teammates

**When to use:** User knows exactly what each teammate should do upfront. Teammates execute autonomously and report back when done. No interactive driving.

**What to ask:**

1. Team name
2. For each teammate: name + concrete task (3-7 sentences, including acceptance criteria + relevant file paths/links)
3. Target branch

**Execute:**

Same as `standby`, but the `prompt` field includes the full task brief instead of standby instructions. Append the same reporting protocol (TaskUpdate completed + SendMessage on done, PR not auto-merge) at the end of each teammate's brief.

### Mode 3: `solo` — Single agent, no team

**When to use:** User has exactly one task, doesn't need parallelism, but wants worktree isolation so the agent can commit/push without touching the user's working copy.

**What to ask:**

1. Agent name (kebab-case)
2. Task brief
3. Target branch

**Execute:**

```
Agent({
  name: "<name>",
  subagent_type: "<inferred>",
  isolation: "worktree",
  prompt: "<task brief + reporting protocol>"
})
```

NO `team_name`. NO `TeamCreate`. SendMessage will not work (no team context) — agent reports by completing TaskUpdate; user reads the result via the agent's transcript.

### Mode 4: `status` — Inspect current team / agents

**Execute:** call `TaskList` (and `TeamList` if available) to show:
- Current team name (if team-lead)
- Teammate names + state (idle / busy / completed)
- Recent TaskUpdate events
- Any pending shutdown / plan-approval requests

If not currently leading a team, say so explicitly.

### Mode 5: `teardown` — Shut down the team

**When to use:** User done with the whole team. Wants all teammates terminated and team unregistered.

**Important: shutdown is cooperative, not enforced.** A teammate must actively call `SendMessage({type: "shutdown_response", approve: true})` to terminate. If it only writes "Acknowledged, shutting down" as plain text without calling the tool, its process keeps running (zombie pane). Don't retry the same `shutdown_request` more than once — same misunderstanding = same result.

**Execute:**

1. For each teammate, `SendMessage({to: "<name>", message: {type: "shutdown_request", reason: "<why>"}})`. Send ONCE, not in a retry loop.
2. Wait ~10 seconds, then check status (TaskList / team registry) to see which teammates terminated.
3. Call `TeamDelete({team_name})` to unregister the team registry, regardless of whether all teammates approved. This frees the team_name for re-use.
4. **For any teammate that did NOT terminate** (zombie pane in iTerm2/tmux):
   - Tell the user explicitly: "Teammate `<name>` không approve shutdown — process còn chạy, worktree đã bị `TeamDelete` xóa nên pane đó là zombie, không edit được gì."
   - Suggest manual cleanup, in this order:
     - **iTerm2 pane:** click pane → `Cmd+W` to close
     - **tmux pane:** focus pane → `Ctrl-B x` confirm
     - **Force kill:** `ps aux | grep claude | grep -i '<teammate-keyword>'` → `kill <PID>` (`kill -9` if SIGTERM ignored)
   - DO NOT try to re-send shutdown_request or attempt automatic kill — Claude (the lead) doesn't have the teammate's PID and doesn't manage iTerm2/tmux directly.
5. Surface worktree cleanup state — depends on `WorktreeRemove` hook config in `~/.claude/settings.json`. If the hook is registered, worktrees are cleaned per its logic; if not (default), worktree dirs/branches are preserved for manual cleanup with `git worktree remove` + `git branch -D`.
6. **After user closes zombie panes manually**, ask the user to ping back ("done, đã đóng pane X"). Then re-run `/nf-agents status` to verify: team registry empty, no leftover claude processes for that team. Only after this confirmation should the user spawn a new team with the same name — otherwise two processes claiming the same teammate name can leak into the new team's registry.

**Nuclear escape hatch — `/exit` from lead:** if zombie teammates won't approve shutdown and `Cmd+W` / `kill` is too tedious, the user can simply run `/exit` in the lead pane. Claude Code shows a dialog "Background work is running — Exit anyway / Stay". Pick **"Exit anyway"** → lead terminates → cascade signal kills all teammates → all panes close → in iTerm2, the entire window/tab closes too. Total cleanup in one action. Tradeoff: lead session is gone (but transcript persists at `~/.claude/projects/.../<session-id>.jsonl`, can `claude --continue` later). Recommend this when user has zombie teammates AND no further work to do in the lead session anyway. Do NOT recommend if the lead has unsaved valuable context — they'd lose the live session.

## Common mistakes to avoid

- **Spawning `Agent` without `team_name`** when the user wanted a team — produces an isolated background agent that can't `SendMessage`. Always confirm: is this part of a team or standalone?
- **Manual `tmux split-window`** + `claude --continue` instead of `Agent + team_name` — the resulting panes look like teammates but have no shared messaging registry. They're independent sessions.
- **Forgetting `isolation: "worktree"`** for code-editing teammates — their work mutates the user's working copy directly. Default to worktree for any agent that will write files.
- **Briefing too vaguely** — agent ends up asking the user clarifying questions mid-task, defeating the point of autonomy. In `tasks` mode, brief should include: scope, acceptance criteria, relevant memory files / docs / paths to read, and the reporting protocol.
- **Auto-merging the agent's branch** — never do this. Always PR.

## Reference

The skill assumes you have, or will write, the following supporting pieces in your own setup:

- A `WorktreeCreate` hook in `~/.claude/settings.json` that bases agent worktrees on the parent session's current `HEAD` instead of `origin/<default-branch>`. Without it, merging an agent's PR back into your feature branch can revert in-progress work.
- An agent-safety convention covering commit, push, and PR rules: agents may auto-commit and auto-push inside their worktree, must open a PR back to the target branch, must never auto-merge, and must never push directly to the target branch.
- A commit-message format you want agents to follow (prefix, ticket-id extraction from branch name, etc.). Bake this into the spawn prompt templates below so every spawned member follows it.

If your team already has these as written rules or hooks, point the skill at them. If not, the patterns above are a reasonable starting point.

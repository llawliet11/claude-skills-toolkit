# Agent Safety Rules

## Permission modes

- NEVER use `mode: "dontAsk"` or `mode: "bypassPermissions"` when spawning agents

## Worktree isolation

`WorktreeCreate` hook (`~/.claude/hooks/worktree-create.sh`) bases new agent worktrees on **parent session's current HEAD**, not `origin/<default-branch>` (binary default overridden).

**Implications when `isolation: "worktree"`:**

- Worktree branch = `worktree/<slug>`, base = parent HEAD at spawn time. The parent branch is the **target branch** for the agent's PR.
- Agent CAN auto-commit + auto-push freely, MUST follow `git.md` commit format (prefix, ticket ID from branch name).
- Worktree branch has NO upstream tracking (`--no-track`). First push: `git push -u origin worktree/<slug>`. Subsequent: plain `git push`.
- Agent CAN open a PR back into the target branch. Always PR — never push directly to target, never auto-merge; user reviews and merges.
- Brief the agent with the target branch name explicitly. Don't let it infer from git state.
- After PR is opened, agent's job is done. Don't squash/delete the worktree branch — user does that post-merge.

## When to delegate code edits

Three placement options. `isolation` is orthogonal to spawn pattern (foreground/background/team) — any pattern can run with or without a worktree.

**A. Stay in main session** — when ALL hold:
- Working tree clean (no uncommitted edits, no live `/tmp/` scratch, no in-flight prod monitoring).
- Edit lands on the branch the main session is already on.
- Trivial 1–2 file edit, nothing else in flight.

**B. Delegate to agent WITHOUT isolation** (omit `isolation` — agent edits parent working dir directly) — when ALL hold:
- Edit lands on the branch the main session is already on.
- Want subagent specialization (e.g. `fullstack-engineer`, `ui-ux-designer`) or a longer-running task than main session should run synchronously.
- File scope is disjoint from any other concurrent edits — main session is NOT editing same files; no other no-isolation agent touching same files.
- No PR/review/CI gate required for this work.

Risks of B (must mitigate):
- Multiple no-isolation agents on overlapping file scope = race conditions, last writer wins, no rollback.
- If `run_in_background: true`, main session is blind to agent's edits — your in-memory view of the tree goes stale; re-read files before further edits.
- No isolated rollback path — if agent corrupts state, revert via git like any other edit.

**C. Delegate to a worktree agent** (`isolation: "worktree"`, usually `run_in_background: true`) — when ANY hold:
- Main session is mid-debug: tailing prod logs, holding `.env*` edits, polling container state, SCP'ing tmp scripts, running monitoring loops.
- Edit targets a different branch than the main session is on.
- Multiple unrelated hotfixes queued — one worktree each keeps them isolated.
- PR/review/CI gate required.

How to delegate (C only):
- Brief the agent with the target branch explicitly. Worktrees base on parent HEAD per "Worktree isolation" above.
- Tell the agent to open a PR back, never auto-merge.
- When the agent reports the PR open, main session merges via `gh pr merge` and `git pull --ff-only` — no `git checkout` to the hotfix branch.

Why C over A/B when mid-debug: sharing the checkout (or switching branches) with active monitoring resets the working tree, orphans scratch files, breaks monitoring loops, and obscures which session-state edit (e.g. `.env.production`) belongs to which task.

---

> **Scope for the two sections below**: applies ONLY when the main session spawns agents/teams. Direct work in the main session (no agents) follows normal git workflow — switching branches, direct edits, etc., are all fine.

## Spawning patterns

1. **Parallel (foreground)** — multiple `Agent` calls in one response block. Main session blocks until all return. Use for independent file scopes when nothing else is in flight.
2. **Sequential** — spawn 1, wait, spawn 2 with knowledge of 1's output. Use when B depends on A, or B's worktree should base on the new HEAD after A is merged into parent.
3. **Background (`run_in_background: true`)** — main session does NOT block; gets notified on completion. Use for long tasks (build, large refactor, deploy) or when main session must stay live (monitoring prod, debugging, polling state). Combinable with parallel.
4. **Teammate (`TeamCreate` + `team_name` + `SendMessage`)** — persistent, addressable agents that can be resumed across turns. Use for coordination (alice writes, bob reviews) or long collaboration. One-shot `Agent` calls cannot be resumed; teammates can via `SendMessage(to=<name>)`. Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (set in `settings.json`).

| Use case | Pattern |
|---|---|
| Independent edits, fast turnaround | Parallel + foreground |
| Independent edits, main session must stay live | Parallel + background |
| Multi-step where B depends on A | Sequential |
| One long task while main session continues | Single background agent |
| Two agents collaborating (write + review) | Team + `SendMessage` |
| Resume an agent later in the session | Team (one-shot can't resume) |

## Integration without switching branches in the main session

Applies to option **C** only (worktree agents). Option B (no-isolation agent) edits the current branch directly — nothing to integrate; just re-read files and continue.

**Rule**: when worktree agents are involved, the main session stays on its starting branch (call it branch A) for the duration. Do NOT `git checkout` to the worktree branch in main — pull or merge instead.

Three ways to integrate `worktree/<slug>` back into branch A (the main session's starting branch):

- **Local merge** — `git fetch origin && git merge --ff-only origin/worktree/<slug>` (or `--no-ff` for a merge commit). Use for personal/feature branch A. No remote required. No review/CI gate.
- **PR + auto-merge** — agent opens PR, CI runs, then `gh pr merge <PR#> --auto --squash`; main session does `git pull --ff-only origin <A>`. Use for shared branch A (`main`, `development`, `staging`) or when review/CI is required. Matches "Worktree isolation" convention. Slower, PR noise for tiny tasks.
- **Cherry-pick / patch** — `git cherry-pick <sha>` or `git format-patch -1 <sha> --stdout | git am`. Use to skip/reorder commits or squash before merging. No remote required. Most manual; error-prone with many concurrent agents.

**Conflict prevention for multi-agent flows**:
- Slice tasks by **file scope** (A: `src/api/`, B: `src/ui/`, C: `docs/`). State scope in each agent's prompt.
- Merge results back into branch A **one at a time**. First merge clean; second may need rebase if scopes overlapped.
- For sequential dependent tasks (B on A): merge A into branch A first, then spawn B — its worktree will base on the updated HEAD via the `WorktreeCreate` hook.

## Incident references

Real incidents that motivated specific rules above. Names anonymized.

- **Agent + `dontAsk` deleted a prod S3 bucket.** An agent spawned with `mode: "dontAsk"` ran `aws s3 rb` on a development bucket. Permanent, unrecoverable. Rule: never use `dontAsk` / `bypassPermissions` when the agent has access to destructive cloud commands. Add `deny` permissions in `settings.json` for `aws s3 rm`, `aws s3 rb`, `aws s3api delete-bucket`, `aws s3api delete-object` regardless.
- **Worktree base mismatch overwrote in-progress work.** Before the `WorktreeCreate` hook was in place, agents with `isolation: "worktree"` worked off `origin/<default-branch>` (binary default) instead of the user's current branch. Merging a finished worktree branch back into the parent feature branch effectively reset it to stale `main`. Fix: `WorktreeCreate` hook bases worktrees on current HEAD. Re-verify after CC version upgrades, the binary occasionally changes default semantics.
- **Branch switching mid-debug obscured scratch state.** Main session was monitoring production (live container polling, `.env.production` editing, scratch scripts on remote hosts) and switched branches twice to apply two unrelated Dockerfile hotfixes. Each `git checkout` reset the working tree mid-debug, leaving scratch state from one task visible inside the other. Should have spawned two worktree agents instead. The "When to delegate code edits" section above codifies this lesson.

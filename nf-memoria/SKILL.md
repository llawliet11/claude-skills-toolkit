---
name: nf-memoria
description: This skill should be used when the user says "/nf-memoria", "save state", "end session để continue sau", "memory để mai tiếp", "save what's next", "write memoria", or any variant indicating they want to capture in-flight context into a memory file so a future session of the SAME repo can resume. Writes to the project's configured memory folder (resolves env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE in .claude/settings.local.json, falls back to user-scope autoMemoryDirectory, then to the binary's own default `~/.claude/projects/<sanitized-cwd>/memory/` so the handoff colocates with whatever auto-memory the binary already writes for this session). Writes canonical memory frontmatter (type=project, project=<git toplevel basename>, cwd=<absolute>, tags=[handoff, in-progress]). Memory file content (frontmatter values + body) is written in English by default. Optional argument is a short topic phrase used in the filename slug. After writing the handoff file, also runs a general auto-memory pass: scans the conversation for durable user/feedback/project/reference learnings, writing new entries or updating same-topic ones in place.
argument-hint: <short-topic>
disable-model-invocation: true
---

# nf-memoria, same-repo state memory

Capture the active conversation's in-flight state into a memory file so the user can end the current session and a future session of the SAME repo picks up the thread without re-discovery.

## When this skill runs

The user is mid-task, wants to stop, and asks for a handoff. Skill ALWAYS writes a single `.md` file under the project's resolved memory folder and ALWAYS appends one index line to that folder's `MEMORY.md`. Skill NEVER edits other memories, NEVER commits, NEVER ends the session itself.

## Step 1, Resolve target memory folder

Run the helper binary. It encodes the full cascade (env, project settings, user settings, binary default), expands `~`, `mkdir -p` the folder, and aborts on the recursive-memory safeguard.

```bash
"$CLAUDE_PROJECT_DIR/skills/nf-memoria/bin/resolve-memory-folder"
# or, if $CLAUDE_PROJECT_DIR is unset:
~/.claude/skills/nf-memoria/bin/resolve-memory-folder
```

The binary is a Go program (source at `go/main.go`, build via `bash go/build.sh`). It must be built once per host before first use; see "Building the helper" below. Output is two lines on stdout: `path=<absolute>` and `source=<env|local-env|local-auto|user|bindef>`. Exit codes:

- `0`, resolved and folder ready
- `2`, recursive-memory conflict (resolved path inside current repo; abort and surface the conflict to the user)
- `4`, `mkdir -p` failed

Print both lines to chat before writing so the user can interrupt if the source or path is wrong.

The cascade the binary implements, for reference:

1. `$CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` in current env.
2. `<git-toplevel>/.claude/settings.local.json`, `.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`.
3. Same file, `.autoMemoryDirectory`.
4. `~/.claude/settings.json`, `.autoMemoryDirectory`.
5. Binary default: `~/.claude/projects/<sanitized-pwd>/memory/` where `<sanitized-pwd>` = `$PWD` with `/` and `.` replaced by `-`. Always defined; the helper `mkdir -p`s it.

## Step 2, Gather handoff content from current conversation

Synthesize from the conversation so the user does not have to dictate. The agent already has full session context.

Pull these signals:

- **Topic**, what task was in flight (e.g. `auth-rewrite`, `og-template-wiring`, `wave14-deploy-debug`).
- **Where left off**, last concrete action taken, current branch, any uncommitted edits, any running background process.
- **What was tried**, list 2-4 attempts with outcomes (worked, failed, partial). Skip turn-by-turn noise, keep what affects the next session.
- **What's next**, 2-5 concrete next steps. Each step is one sentence with a verb.
- **Files touched**, file paths edited or read meaningfully in this session, each with one phrase on what changed.
- **Decisions made**, any non-obvious choice plus the reason behind it. Future-self needs the rationale.
- **Open questions**, anything pending user input or external answer.
- **Reproduction context**, exact commands or URLs to get back into the same state (e.g. dev server port, container name, branch to check out).

If the conversation has been short or generic and there is no clear in-flight task, ask once via `AskUserQuestion` (header: `Topic`) for a topic phrase, then proceed. Do not ask for each section, synthesize.

## Step 3, Filename and frontmatter

Filename format:

```
handoff-<topic-kebab>-<YYYYMMDD>.md
```

- `<topic-kebab>` is the argument if provided, else derived from synthesized topic (kebab-case, ASCII, max ~30 chars). Strip accents.
- `<YYYYMMDD>` is today's date in absolute form (UTC date is fine; use system date).
- Total filename target under ~60 chars including `.md`.

Examples:

- `handoff-og-template-wiring-20260519.md`
- `handoff-auth-rewrite-20260519.md`
- `handoff-wave14-debug-20260519.md`

If the host setup enforces a filename suffix convention via a PreToolUse Write hook (some users configure one to append a cwd-slug or similar marker), respect the hook's denial message and re-emit with the expected suffix.

Frontmatter, write exactly this canonical shape:

```yaml
---
name: handoff-<topic>-<date>
description: <one-line: where left off plus what's the very next step>
metadata:
  type: project
  project: <git toplevel basename, NOT worktree slug>
  cwd: <absolute path of project toplevel, NOT worktree path>
  tags: [handoff, in-progress]
  related: []
---
```

Rules:

- `name` is the logical slug (filename minus `.md`). E.g. file `handoff-og-template-20260519.md`, `name: handoff-og-template-20260519`.
- `description` reads like a tweet for next-session-self. Must include both "where" and "next" in one sentence.
- `metadata.type` is always `project`.
- `metadata.project` is the git toplevel basename. If cwd is inside `.claude/worktrees/<slug>/`, walk up to the real repo and use that basename. NEVER use the worktree branch slug.
- `metadata.cwd` is the absolute toplevel path. Resolve `~` to `$HOME`. NEVER substitute worktree path.
- `metadata.tags` always includes `handoff` and `in-progress`. Add 1-2 more domain tags if obvious from context (e.g. `deploy`, `auth`, `og-image`). Cap at 5.
- `metadata.related` lists slugs of existing memories referenced via `[[wikilink]]` in the body. Omit the key if empty.
- Do NOT add `created`, `originSessionId`, `last_read`. Those are binary-auto-injected at top level when the CC binary owns the file.

## Step 4, Body template

Write all sections, even if some are empty (write the section heading plus `_none_`). Empty sections tell next-session-self "I checked, nothing here" vs "forgot to capture".

```markdown
## Where I left off

<2-4 sentences. Current state, last concrete action, branch, dirty tree y/n, any running process>

## What I tried

- <attempt 1>, <outcome>
- <attempt 2>, <outcome>

## What's next

1. <verb> <object>, <expected outcome>
2. <verb> <object>, <expected outcome>

## Files touched

- `path/to/file.ext`, <one phrase on what changed or was discovered>

## Decisions made

- <choice>, <reason>

## Open questions

- <question>, <who or what to ask>

## Reproduction context

- Branch: `<branch>`
- Dev server: `<port plus how to start>`
- Background processes: `<list, or none>`
- Useful URLs: `<list, or none>`

## Resume hint

In a new session at `<cwd>`, say: "resume from handoff [[<this-slug>]]"
```

Body language: English by default. Keep verbatim user quotes and project-specific entities (client names, internal terms) in their original form. Response to the user in chat is unaffected, follow whatever language convention your session already uses.

Keep total body under ~400 lines. If a section grows beyond 10 bullets, split it or compress.

## Step 5, Write the file

Use the `Write` tool. Target path is `<resolved-folder>/<filename>.md`. If the folder doesn't exist, create it first (`mkdir -p`).

If a file with the same name already exists, do NOT overwrite. Insert a numeric disambiguator: `handoff-<topic>-<date>-2.md`, `-3.md`, etc.

## Step 6, Append index line to MEMORY.md

The `MEMORY.md` in the resolved folder is the index. Append (do not insert mid-file) one line:

```
- [<slug>](<filename>), <one-line description matching frontmatter description>
```

Keep the line under 150 chars (the CC binary truncates the index after line 200, and overly long lines also hurt readability).

If `MEMORY.md` does not exist in the resolved folder, create it with a `# Memory Index` heading then the new line.

## Step 7, Run general auto-memory pass

The handoff file captures *in-flight state*. Separately, this step captures *durable knowledge* from the same conversation, anything that matches the standard auto-memory types: `user`, `feedback`, `project`, `reference`.

**Pre-scan: use the in-prompt MEMORY.md index first.** If the resolved folder's `MEMORY.md` is auto-loaded into the prompt context at session start, read those index lines BEFORE scanning the conversation. Use them to:

- Identify topics already covered (skip re-discovery; map a candidate to an existing slug if it fits).
- Decide update-in-place vs new-file without a separate grep pass for each candidate.
- Prune the conversation scan to "what's new or what updates an existing entry", not a full open-ended sweep.

If the in-prompt index is truncated or a candidate's slug isn't obvious from the index descriptions, grep the resolved memory folder as a fallback. Otherwise, the index alone is enough.

Then scan the conversation for candidates:

- **user**, new facts about who the user is, their role, expertise, preferences.
- **feedback**, corrections the user gave OR non-obvious approaches they validated. Save with **Why:** and **How to apply:** lines.
- **project**, who is doing what, why, by when; decisions and motivations that aren't derivable from code or git.
- **reference**, pointers to external systems (Linear projects, Grafana boards, Slack channels, runbook URLs).

For each candidate:

1. Grep the resolved memory folder for an existing entry on the same topic. If found, update it in place.
2. If not found, write a new file `<type>_<short-slug>.md` (e.g. `feedback_prefers_arrays_over_strings.md`, `project_billing_revamp_q3.md`).
3. Update `MEMORY.md` in the resolved folder: add a new index line for new files, leave existing lines alone for updates.

Skip silently when:

- The conversation only contains in-flight state already captured in the handoff file (e.g. "what was tried" attempts that aren't durable lessons).
- A candidate is already covered by an existing memory verbatim.
- The candidate falls under "What NOT to save in memory" (code patterns, file paths, git history, debugging recipes, ephemeral task details).

Report each auto-memory action (`+ wrote <slug>`, `~ updated <slug>`, or `none, no durable learnings`) in the Step 8 chat output. This is in addition to the handoff file itself, never replaces it.

Constraints:

- Do NOT dedupe or re-organize unrelated existing memories.
- Do NOT cross project boundaries. Memory writes target the resolved folder for THIS session's project only.
- Do NOT auto-commit memory files. If the resolved folder is under version control (e.g. a memory git submodule), let the user or a dedicated background session handle commits.

## Step 8, Report and stop

Output is a colorful, clickable report rendered in **markdown**. Claude Code TUI strips raw ANSI/OSC8 escape sequences from chat output (those only render in statusline / raw printf). Markdown bold, italics, code spans, and link syntax all render with terminal styling in the TUI. Each filename is a markdown link to `vscode://file/<abs-path>` so the user can click to open it in VS Code.

### Render template

Emit exactly this markdown (substitute placeholders; preserve blank lines):

```markdown
**Memory folder:** `<resolved-folder>` *(source: <source>)*

**Files written:**
- `+` [`<filename>`](vscode://file/<abs-path>), *<description from frontmatter>*
- `~` [`<filename>`](vscode://file/<abs-path>), *<description from frontmatter>*

**Preview:**
- **Where:** <one-line synthesis of "Where I left off">
- **Next:** <first item from "What's next">

**Resume:** `resume from handoff [[<slug>]]`
```

Notes:

- `<abs-path>` is the absolute path to the file (resolved memory folder plus `/` plus filename). The double slash after `vscode://file` is correct for Unix absolute paths.
- `+` marker = new file. `~` marker = updated-in-place file (only Step 7 auto-memory uses `~`; the handoff file itself is always `+`).
- Do NOT emit any `\033[...m` ANSI codes or OSC8 `\033]8;;...` sequences in the chat, they render as literal text in the TUI. Markdown is the only path to styled chat output.

### Order of "Files written"

1. The new handoff file (always `+`).
2. Each auto-memory file from Step 7, `+` if newly written, `~` if updated in place. If Step 7 produced none, omit those lines entirely (do not print a placeholder line).

If a file lives outside the resolved memory folder (rare), use its true absolute path in the markdown link.

After the report, stop. Do NOT ask "anything else?". Do NOT offer to commit. Do NOT exit the session, the user does that themselves.

## What NOT to do

- Do NOT write outside the resolved memory folder.
- Do NOT use `metadata.project: <worktree-slug>`, always the real repo basename.
- Do NOT inline the full conversation transcript, synthesize, do not dump.
- Do NOT add `Co-Authored-By`, `Generated with Claude`, emojis, or AI-attribution lines.
- Do NOT dedupe or re-organize unrelated existing memories. (Step 7's auto-memory pass MAY update an existing same-topic memory in place; that is not dedupe.)
- Do NOT auto-commit the memory folder.
- Do NOT prompt the user to type each section by hand, synthesize from conversation context.

## Edge cases

- **No git repo**, `git rev-parse --show-toplevel` fails. Fall back to `pwd` for both `cwd` and basename. Note this in the description.
- **Inside a worktree**, resolve to the real repo via `git rev-parse --path-format=absolute --git-common-dir` and walk to `worktrees/../..`. Easier: use `git rev-parse --show-superproject-working-tree` or check `.git` file pointing to `gitdir: .../worktrees/<slug>`. Practical shortcut: `git worktree list | head -1 | awk '{print $1}'` gives the main toplevel.
- **Resolved folder is the binary default (`~/.claude/projects/<sanitized-cwd>/memory/`)**, that is the per-session folder the binary uses by default. Handoff lives next to whatever auto-memory the binary already wrote. `metadata.project` stays the git toplevel basename (NOT the sanitized cwd, NOT `generic`) so per-project filtering still works.
- **User explicitly names a folder via argument** (e.g. `/nf-memoria og-template`), the argument is the topic, NOT a folder override. Folder resolution still follows Step 1.

## Building the helper

The Go source lives at `go/main.go` with a build script at `go/build.sh`. After cloning this skill into `~/.claude/skills/nf-memoria/`, build the binary once per host:

```bash
cd ~/.claude/skills/nf-memoria/go
bash build.sh        # builds for current OS/arch into ../bin/resolve-memory-folder
# or
bash build.sh --all  # cross-compile darwin-arm64, linux-amd64, linux-arm64
```

Go 1.22+ is required. The binary has no runtime dependencies. To rebuild after editing the source, re-run `bash go/build.sh`.

If your host does not have Go installed and you do not want to install it, port `go/main.go` to your preferred runtime (the cascade logic is short and self-contained), or skip this skill.

## Resume protocol (informational, for the future session)

When a future session sees the user say "resume from handoff [[<slug>]]" or similar, that session should:

1. Find the file by slug in the configured memory folder.
2. Read it.
3. Restate "Where I left off" plus "What's next" so the user confirms.
4. Re-establish reproduction context (cd to `cwd`, check out branch, start dev server if listed).
5. Begin executing the first "What's next" item.

This protocol is documented here so the handoff body does not need to repeat it.

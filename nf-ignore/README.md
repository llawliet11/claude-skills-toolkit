# nf-ignore

A Claude Code skill that **audits and patches `.gitignore`** for AI coding tools and env files. Detects the project's framework (Vite, Next.js, Nuxt, Astro, SvelteKit, Remix) versus plain Node.js to apply the right env convention, and ignores only personal AI tool files while keeping team-shared configs committed.

This is the white-labeled, shareable version of a skill I use day to day. Examples and references have been generalized so you can drop it into any setup.

Blog write-up: [nf-ignore, a `.gitignore` auditor for AI tools and env files](https://blog.nghia-pham.com/blog/nf-ignore/).

## Why this skill exists

`.gitignore` failures are silent. A pattern that is too broad blocks the file you wanted everyone to see, for weeks, until someone runs `git status` on a fresh clone and notices the team-shared config is missing. A pattern that is too loose lets a developer leak `.env` into git because the framework's convention says "track `.env.development` as a shared default" and the gitignore was written for plain Node.js.

The two most common failure modes:

1. **AI coding tools.** A repo has `.claude/` in `.gitignore`, which silently blocks the team-shared `.claude/settings.json`, `.claude/skills/`, and `.claude/agents/` that should be tracked. Same shape with `.cursor/`, `.windsurf/`, `.continue/`. The pattern is too broad. It ignores personal files plus shared config.
2. **Env files.** A repo uses Vite and the developer adds `.env.*` to `.gitignore`. Now `.env.development` and `.env.production` (which Vite explicitly tracks for shared defaults) are blocked. The convention falls back to "everyone has to share `.env` files via chat".

`nf-ignore` audits an existing `.gitignore`, detects the project's framework, and patches in the right patterns for both categories.

## Install

1. Copy the `nf-ignore/` folder into `~/.claude/skills/`:

   ```bash
   cp -r nf-ignore ~/.claude/skills/
   ```

   The end result should be `~/.claude/skills/nf-ignore/SKILL.md`.

2. Verify Claude Code sees it. In a new Claude Code session, type `/nf-ignore` from any project directory and the skill should appear.

## Required environment

- **Cwd is a git repo (or a directory you intend to make into one).** The skill writes to `<cwd>/.gitignore`. If `.gitignore` does not exist, the skill offers to create it.
- **`package.json` is the primary signal for framework detection.** The skill reads `dependencies` and `devDependencies` to confirm a framework. If your repo has no `package.json` (e.g. pure Python, Go, Rust), the framework checks are skipped; the AI tool patterns still apply.
- **Workspace files for monorepos.** Root `package.json#workspaces` or `pnpm-workspace.yaml`; the skill recurses into each workspace directory for per-workspace classification.

## Usage

Invoke from any project's root directory:

```text
/nf-ignore
```

No arguments. The skill:

1. Detects the framework (Vite/Next/Nuxt/Astro/SvelteKit/Remix) or marks the repo as plain Node.js / unknown.
2. Reads the existing `.gitignore`.
3. Generates a four-section report (Detected, Fix, Add, OK).
4. Asks for confirmation via `AskUserQuestion`.
5. Patches `.gitignore` in place (preserves existing formatting; appends new sections with headers).
6. Reminds you to run `git status` and `git rm --cached <file>` for anything that was tracked under the wrong convention.

## What the skill does (step by step)

1. **Detect.** Three checks: framework config files, `package.json` deps, monorepo workspaces. First two should agree; if they disagree, prefer the framework that appears in dependencies. If neither produces a hit, treat as plain Node.js. If ambiguous, ask.
2. **Audit.** Reads existing `.gitignore` and classifies each line as overly broad (blocks team-shared files), wrong env policy (mismatch with detected framework), unknown/suspicious (looks AI- or env-related but unrecognized), or already correct.
3. **Report.** Four-section summary. The user sees exactly what would change before anything is written.
4. **Apply.** Writes new sections with explanatory headers. Existing comments and groups are preserved. The skill never removes a pattern silently; if a removal is needed, it asks.

## The patterns this skill encodes

**AI tool patterns**, personal-only entries for ten tools (Claude Code, Cursor, Windsurf/Codeium, Aider, Codex CLI, Continue.dev, Cody, Tabnine, Amazon Q, Supermaven). Each entry is the file or folder that should be local to the developer. The team-shared files for each tool (rules, settings, agents) are explicitly **not** ignored.

**Env patterns**, three scenarios:

- **Framework project:** `.env*.local` plus `.envrc`. Shared defaults (`.env`, `.env.development`, `.env.production`) stay tracked because Vite/Next/Nuxt/Astro/SvelteKit/Remix all use them for non-secret build-time configuration.
- **Plain Node.js:** `.env`, `.env.*`, `!.env.example`, `.envrc`. All env files are secrets; only the example is tracked.
- **Mixed monorepo:** per-workspace blocks. Frontend workspaces get the framework pattern; plain Node.js workspaces get the strict pattern, scoped by path.

## Customizing

- **Tool list goes stale.** The AI ecosystem moves fast; new editors appear quarterly. To add a new tool, edit Part 1 of `SKILL.md` and add (a) the personal-only pattern, (b) the shared file(s) that should stay committed in the table. The same convention applies to almost every modern AI tool: one rules/settings file or folder is team-shared, one is personal-overrides.
- **Framework list.** Six frameworks are encoded. If your stack uses something different (Gatsby, Solid, Qwik, Fresh, etc.), add the config file and the dependency name to the detection checks in Part 2.
- **Per-tool comments.** The default report uses concise reasons ("too broad: blocks team-shared `.claude/settings.json`"). If you want longer explanations, edit the report templates in Phase 2 of the workflow section.

## Anti-patterns

- Do not run `/nf-ignore` and then immediately push without `git status`. The skill warns when an existing tracked file might need `git rm --cached`, but it cannot un-track files itself. Run `git status` after every patch and act on anything unexpected.
- Do not remove the skill's `disable-model-invocation: true` unless you have a reason. The default is invocation-only because gitignore changes affect the entire repo; you want the user to explicitly type the slash command.
- Do not edit `.gitignore` manually while the skill is reading it. The skill `Read`s, builds the audit, then `Write`s. Concurrent edits between those steps are lost.
- Do not use this skill on a non-git directory unless you actively want to create `.gitignore`. The skill warns first but proceeds if you confirm; downstream tools (commit hooks, lint) may not expect `.gitignore` in a non-repo.

## License

MIT. See `LICENSE`.

---
name: nf-ignore
description: "Audit and fix .gitignore for AI coding tools and env files. Smart detection of framework env convention (Vite/Next/Nuxt/Astro/SvelteKit/Remix vs plain Node.js). Ignores only personal/local files, keeps team-shared configs committed. Usage: /nf-ignore. Use when user initializes a project, sets up gitignore, sees AI config or env files in git status, or asks about what to ignore vs commit."
disable-model-invocation: true
---

# AI Gitignore

Add `.gitignore` patterns for **AI coding tools** and **env files**. Only ignores personal/local files; team-shared configs (rules, instructions, shared settings, framework env defaults) stay committed.

## Part 1, AI tool patterns (always applied)

```gitignore
# AI Coding Tools, personal/local files only
# Team-shared configs (rules, instructions, settings) are NOT ignored
# Added by /nf-ignore

# Local conventions
.local/

# Claude Code
CLAUDE.local.md
.claude/settings.local.json

# Cursor
.cursorignore
.cursorindexingignore

# Windsurf/Codeium
.codeiumignore

# Aider
.aider*

# Codex CLI
.codex/

# Continue.dev
.continue/config.yaml
.continueignore

# Sourcegraph Cody
.cody/ignore

# Tabnine
.tabnine*

# Amazon Q
.amazonq/

# Supermaven
.supermaven/
```

### What should be COMMITTED (do NOT ignore these)

| Tool | Shared files |
|------|-------------|
| Claude Code | `CLAUDE.md`, `.claude/settings.json`, `.claude/skills/`, `.claude/agents/` |
| Cursor | `.cursor/rules/*.mdc`, `.cursorrules` |
| Copilot | `.github/copilot-instructions.md`, `.github/instructions/`, `.github/agents/` |
| Windsurf | `.windsurf/rules/`, `.windsurfrules` |
| Codex CLI | `AGENTS.md` |
| Continue.dev | `.continue/rules/` |

## Part 2, Env file patterns (smart detection)

The correct env pattern depends on the project's framework. Detect first, then apply.

### Detection (run at repo root)

**Check 1, Framework config files:**

- `vite.config.{js,ts,mjs,cjs}` indicates Vite
- `next.config.{js,ts,mjs,cjs}` indicates Next.js
- `nuxt.config.{js,ts,mjs,cjs}` indicates Nuxt
- `astro.config.{js,ts,mjs,cjs}` indicates Astro
- `svelte.config.{js,ts,mjs,cjs}` indicates SvelteKit
- `remix.config.{js,ts,mjs,cjs}` / `react-router.config.{js,ts}` indicates Remix

**Check 2, `package.json` dependencies/devDependencies:**

`vite`, `next`, `nuxt`, `astro`, `@sveltejs/kit`, `@remix-run/dev`, `react-scripts`

**Check 3, Monorepo workspaces:**

If root `package.json` has `workspaces` (or `pnpm-workspace.yaml` exists), scan each workspace dir using Check 1 + Check 2 to classify it as `framework` or `plain`.

### Three scenarios

#### Scenario A, Framework-only project

Detected: Vite/Next/Nuxt/Astro/SvelteKit/Remix.

```gitignore
# Secrets & env, Vite/Next.js/Nuxt/Astro/SvelteKit/Remix convention
# Shared defaults (.env, .env.development, .env.production) are tracked
# Personal overrides (.env.local, .env.*.local) are ignored
.env*.local
.envrc
```

#### Scenario B, Plain Node.js project

No framework detected (e.g. Express, NestJS, plain scripts).

```gitignore
# Secrets & env, plain Node.js (all .env* contain secrets)
.env
.env.*
!.env.example
.envrc
```

#### Scenario C, Mixed monorepo (frontend + plain backend)

Some workspaces are framework-based, others are plain Node.js.

```gitignore
# Secrets & env
.envrc

# Frontend workspaces (Vite/Next convention)
.env*.local

# Plain Node.js workspaces (list each detected plain workspace)
apps/api/.env
apps/api/.env.*
!apps/api/.env.example
```

Add one block per detected plain workspace.

#### Scenario D, Ambiguous

If detection cannot decide (no configs, no recognizable deps), ask user:

> "Cannot auto-detect env convention. Which fits this project?
> 1. Framework (Vite/Next/Nuxt/Astro/SvelteKit/Remix), track `.env`/`.env.[mode]`, ignore only `.local` overrides
> 2. Plain Node.js, ignore all `.env*` except `.env.example`
> 3. Mixed monorepo"

## Workflow

### Phase 1: Detect & Audit

1. Run env detection (framework configs + package.json deps + workspaces).
2. Read the project's `.gitignore` (if it exists).
3. **Detect overly broad patterns** that block team-shared files:
   - `.claude/` should be `.claude/settings.local.json`
   - `.cursor/` should be `.cursorignore` + `.cursorindexingignore`
   - `.windsurf/` should be `.codeiumignore`
   - `.github/copilot-instructions.md` ignored should be tracked
   - `.continue/` should be `.continue/config.yaml` + `.continueignore`
4. **Detect env policy mismatch**:
   - Framework project but `.gitignore` has `.env.*` (blocks Vite/Next shared defaults), suggest replacing with `.env*.local`
   - Plain Node.js but `.gitignore` only has `.env*.local` (secrets in `.env` leaking), suggest adding strict `.env` + `.env.*` + `!.env.example`
   - Mixed monorepo using one-size-fits-all pattern, suggest scoped rules per workspace
5. **Detect unknown or suspicious patterns** that look AI- or env-related but are not recognized, ask user instead of skipping silently.

### Phase 2: Report

6. Present the report with these sections:
   - **Detected:** project type (framework name, plain Node.js, or mixed monorepo + workspace breakdown)
   - **Fix:** overly broad or wrong-convention patterns to replace
   - **Add:** missing patterns
   - **OK:** patterns already correctly present
7. If anything is unclear, ask before proceeding.

### Phase 3: Apply

8. Ask for confirmation.
9. Apply changes: replace broad patterns, append missing ones with section headers.
10. Remind user to check `git status` (and `git rm --cached` if files were already tracked under wrong convention).

## Rules

- NEVER remove existing patterns without asking
- NEVER silently skip problems, always surface to the user
- Always show full report (Detected/Fix/Add/OK) before writing
- Always ask for confirmation before writing
- Preserve existing .gitignore formatting
- If not a git repository, warn but still offer to create .gitignore
- Skill scope is gitignore only, do not create/modify `.env.example` or other files

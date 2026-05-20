# Claude Skills Toolkit

A collection of [Claude Code](https://docs.claude.com/en/docs/claude-code) skills that I have built, refined through actual use, and white-labeled so they drop into any setup.

A Claude Code **skill** is just a folder under `~/.claude/skills/<name>/` with a `SKILL.md` file. The frontmatter declares when the skill should trigger, the body tells the model what to do once it has triggered. No build step, no plugin runtime, no manifest registry. That simplicity is what makes them shareable.

This repo holds the skills I have decided are worth publishing. Each one captures a workflow I have refined over weeks (the questions I ask myself, the steps I do not skip, the mistakes I have already paid for) so it re-runs deterministically every time.

## Skills in this toolkit

| Skill | What it does | Write-up |
|---|---|---|
| [`nf-agents`](./nf-agents/) | Spawn Claude Code teams or single agents safely. Five named modes (`standby`, `tasks`, `solo`, `status`, `teardown`), pre-flight checks, cooperative shutdown protocol. Bundles two companion rules (`rules/agent-safety.md`, `rules/git.md`) the skill's prompt templates assume. | [Blog post](https://blog.nghia-pham.com/blog/nf-agents/) |
| [`nf-dream`](./nf-dream/) | Consolidate filesystem-based session memory. Classifies markdown memory files into Now / Next / Done / Future / Reference / Stale, normalizes legacy frontmatter, rewrites the index, generates a per-project handoff, archives aged session-end states, dedupes, lints, backfills project tags, translates non-English entries to English, rolls back. Project-scoped, dry-run by default, snapshots before every write. Twelve modes, scripts + registries under `scripts/` and `references/`. | [Blog post](https://blog.nghia-pham.com/blog/nf-dream/) |
| [`nf-git-workflow`](./nf-git-workflow/) | Install a project-scoped git workflow rule that overrides the global ask-before-every-commit safety rule for one repo only. Three authorization modes (`worktree-pr`, `worktree-local-merge`, `direct-on-head`) define how work lands on the protected head branch. Stack-agnostic scaffold with TODO markers for preconditions and authorized scope. | [Blog post](https://blog.nghia-pham.com/blog/nf-git-workflow/) |
| [`nf-memory`](./nf-memory/) | Configure a project to use a shared memory folder via `autoMemoryDirectory` in `.claude/settings.local.json`. Interactive picker over existing folders under `~/.claude/memory/`, validation, recursive-memory safeguard, and optional smart-merge migration from the old shared folder and/or project-local memory. Sources are read-only. Pairs with `nf-dream` for the consolidation half of the pipeline. | [Blog post](https://blog.nghia-pham.com/blog/nf-memory/) |
| [`nf-cc-sync`](./nf-cc-sync/) | Sync `~/.claude/` between machines using a branch-per-machine git layout. Pull-only, key-level merge for `settings.json`, prefer-newer for skills and rules, never auto-deletes. Auto-commits a dirty tree first; reconciles an optional `memory/` submodule independently. The OTHER branch is read-only from the current machine's perspective. | [Blog post](https://blog.nghia-pham.com/blog/nf-cc-sync/) |
| [`nf-ignore`](./nf-ignore/) | Audit and patch `.gitignore` for AI coding tool patterns and env policy. Detects framework (Vite/Next/Nuxt/Astro/SvelteKit/Remix) vs plain Node.js to pick the right env convention. Ignores only personal AI tool files; team-shared rules and settings stay committed. Four-section report (Detected/Fix/Add/OK) before any write. | [Blog post](https://blog.nghia-pham.com/blog/nf-ignore/) |
| [`nf-direnv`](./nf-direnv/) | Set up `.envrc` in the current repo with `GH_TOKEN` resolved dynamically via `gh auth`. Picks the right `gh` account for multi-account setups, verifies `.envrc` is gitignored, runs `direnv allow`. Uses `$(gh auth token --user X)` so the plaintext token never lands on disk and rotation is automatic. | [Blog post](https://blog.nghia-pham.com/blog/nf-direnv/) |

More skills will land here as I white-label them.

## Installing a skill

Each skill folder is self-contained. To install `nf-agents`:

```bash
# Clone the repo (or download a release zip, see Releases tab)
git clone https://github.com/llawliet11/claude-skills-toolkit.git

# Copy the skill folder into your Claude Code skills directory
cp -r claude-skills-toolkit/nf-agents ~/.claude/skills/

# Verify in a new Claude Code session
# Type /nf-agents and the skill should appear
```

Each skill has its own `README.md` describing required environment, customization options, and install caveats. Read it before using.

## Conventions

- **One skill per folder.** Each folder under the repo root is one independent skill, identified by its folder name (which matches `name:` in the skill frontmatter).
- **`disable-model-invocation: true`** is the default for skills that take real actions or spend time. The model will not auto-trigger; the user has to type `/skill-name` explicitly. Edit the frontmatter if you want auto-trigger.
- **White-labeled.** Examples and references inside each `SKILL.md` are generalized. No client names, no internal infrastructure, no project-specific assumptions. You should be able to drop a skill into your own setup and have it work without rewriting.
- **MIT licensed.** Use, modify, redistribute. No warranty.

## Releases

Tagged releases attach a zip per skill, ready to drop into `~/.claude/skills/`. Check the [Releases](https://github.com/llawliet11/claude-skills-toolkit/releases) tab for the latest.

If you prefer the bleeding edge, clone the repo and pull periodically.

## Contributing

This is primarily a personal toolkit, but I welcome:

- Bug reports for skills that do not work as documented.
- Feedback on failure modes I have not yet hit.
- Suggested improvements, particularly to the prompt templates.

Open an issue or a PR. For larger pattern discussions, the blog write-ups are a better place to thread the conversation.

## Why share skills

Most Claude Code tutorials show you what the model can do. Few of them show you the **scaffolding** people put around the model to make it dependable, the small files that turn ad-hoc prompting into a stable workflow.

Skills are exactly that scaffolding. They live in plain markdown, they are version-controllable, and they encode hard-won lessons (mostly the result of incidents). Sharing them is high-leverage because the format is portable: copy the folder, edit the parts that mention your tools, and the skill works in your environment too.

I am also writing this for myself. Forcing myself to white-label and explain a skill is the cleanest way to find the parts that are crufty, the parts that only worked because of one specific project, and the parts that deserve to be promoted into a global rule.

## Author

Nia D Pham (`xinchao@nghia-pham.com`) - blog at https://blog.nghia-pham.com.

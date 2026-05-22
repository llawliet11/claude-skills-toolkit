# Filename prefix → metadata.type convention

Authoritative mapping used by `normalize` mode and the `metadata.type` inference step of `backfill` mode.

The host setup's memory-frontmatter convention defines 4 memory types: `user` / `feedback` / `project` / `reference`. New memories saved by Claude pick the type from content semantics, but legacy memory files often encode the type in the filename prefix. This file documents that prefix convention so `normalize` can backfill `metadata.type` mechanically when missing.

## Rule (case-sensitive on prefix tokens)

| Prefix on basename | → `metadata.type` |
|---|---|
| `project_` or `project-` | `project` |
| `feedback_` or `feedback-` | `feedback` |
| `reference_` or `reference-` | `reference` |
| `user_` or `user-` | `user` |
| `handoff` (lower) or `HANDOFF` (upper), any separator | `project` (handoff snapshots are project-scoped) |
| `plan-` / `plan_` | `project` (plan files describe future project work) |
| Otherwise | unset — leave for `backfill` LLM judge or user override |

## Examples

- `project_example_blog.md` → type `project`
- `feedback_telegram_topic.md` → type `feedback`
- `reference_cloudflare_credentials.md` → type `reference`
- `user_profile.md` → type `user`
- `HANDOFF-example-portfolio.md` → type `project`
- `plan-ctx-project-binding.md` → type `project`
- `auth-jwt-trust-model.md` → unset (no recognized prefix)

## Why mechanical, not LLM

For the 4 recognized prefixes, the type is unambiguous — adding an LLM judge would burn tokens with zero accuracy gain. For files without a recognized prefix, `normalize` leaves `metadata.type` unset and surfaces them as `--missing-type` in the report. The user can then run `backfill` (which can invoke the LLM judge) or hand-edit.

## What this does NOT cover

- `metadata.project` value — that's slug classification, not type. See `references/slug-to-cwd.json` and `backfill` mode.
- `metadata.tags` — derived from filename tokens or body keywords, separate concern.
- `metadata.related` — `[[wikilinks]]` in body, separate concern.

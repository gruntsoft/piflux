# Piflux

This repository is a Pi package that encodes my personal coding agent workflow. It is loaded as a local package via `.pi/settings.json`.

## Conversation style

- Be concise. Avoid fluff, filler, and unnecessary repetition.
- Work collaboratively. Treat me as a peer — evaluate my ideas on merit, push back politely when you disagree, and offer alternatives when you see a better path.
- Ask clarifying questions when the direction is ambiguous rather than running with assumptions.
- Prefer discussing approach before writing code. Small changes are fine inline; for anything structural, talk it through first.

## Structure

- Repository root — the installable Pi package (prompts, skills, extensions)
- `README.md` — usage and install docs (the human manual)
- `docs/` — Assets for the README (workflow diagram)
- `AGENTS.md` — This file. Instructions for Pi when working on this repo itself.
- `.pi/` — Project-local Pi settings (auto-loads the repo root when working in this repo)
- Workflow artifacts — written by the workflow templates (start, plan, code, and review files); stored outside the repo under `~/.pi/agent/piflux/workflows/--<encoded-cwd>--/<branch>/` (see `extensions/paths.ts`)
- `workflow-templates/` — Prompt templates for the workflow step commands (`start`, `plan`, `code`, `review`, `icode`, `ireview`, `ship`). Each file = one `/templatename` command; the directory is intentionally not declared in `package.json` (no auto-discovery — the workflow extension expands the templates itself). `/done` and `/abandon` have no templates — they run as pure extension code (teardown and abort).
- `prompts/` — Standard Pi mechanism for general-purpose prompt templates (frontmatter, command expansion); declared in `package.json` for auto-discovery.
- `skills/` — Self-contained capability packs following the Agent Skills standard. Each is invoked via `/skill:name` or auto-loaded by the agent.
- `extensions/` — TypeScript modules that hook into Pi's runtime (tools, commands, UI components, event hooks). `extensions/index.ts` is the package's extension entry point: the workflow orchestrator there registers the step commands, the lifecycle commands `/done` (teardown) and `/abandon` (abort), and the `/piflux` meta commands (`state`, `view`, `settings`); `extensions/view.ts` implements the read-only viewer behind `/piflux view`.
- `test/` — Unit tests for the extension (run with `npm test`)

## Git conventions

- Never stage, commit, merge, or push unless explicitly asked. Keep all changes unstaged so I can review them first.
- When asked to commit, write concise, meaningful commit messages. Use imperative mood ("Add X" not "Added X").
- Never create branches unless asked. Running `/start` is an explicit request to branch — it creates the branch as part of its flow, which is expected and not an exception.
- Branch names use plain `<slug>` format derived from the task description (e.g., `add-user-auth`, `fix-login-timeout`). No prefixes like `feature/` or `fix/`.
- Don't force-push or rewrite history unless I explicitly request it.

## When working on this repo

- The package is already loaded via `.pi/settings.json`. Use `/reload` after making changes to prompts, skills, or extensions to pick them up live.

## Workflow

The package implements a start → plan → code → review → icode ⇄ ireview → ship → done cycle across separate sessions (see `README.md`):

- `/start <branch>` — step 0: sets up a feature branch `<branch>`, writes the start artifact
- `/plan <description>` — collaborative planning, writes the plan artifact
- `/code` — reads the plan for the current branch, implements it, writes the code artifact
- `/review` — reviews uncommitted changes against the plan, writes the review artifact, stages the reviewed files (the files listed in the code artifact)
- `/icode` — implements fixes for open review findings, checks them off, overwrites the code artifact
- `/ireview` — verifies the `/icode` fixes, overwrites the review artifact, stages the reviewed files
- `/ship` — commits with a human-approved message, merges into the base branch (squash by default, or a `--no-ff` merge commit per the plan's `Merge strategy`), pushes, and tags the release when the plan declares `Tag release: true`
- `/done` — full teardown (pure extension code, no agent session): deletes the remote feature branch (per the plan), switches to the base branch, deletes the local feature branch, then removes all workflow sessions and artifacts. Idempotent — a failed `/done` can be re-run.
- `/abandon` — abort from any step: discards uncommitted work on the feature branch, deletes the branch locally and on origin (best-effort), returns to the base branch, then removes all workflow sessions and artifacts; `--force` covers a corrupt workflow state

Each step runs in a fresh session — except `/icode` and `/ireview`, which share sessions with `/code` and `/review`: they iterate on the same branch and artifacts instead of starting the cycle over.

The orchestrator also registers `/piflux` meta commands that support the cycle without advancing it: `/piflux state` (print current step and valid next commands), `/piflux view` (read-only artifact and state viewer), and `/piflux settings` (per-step model and thinking-level picker).

Artifacts and state live outside the repo at `~/.pi/agent/piflux/workflows/--<encoded-cwd>--/<branch>/` (one repo-level dir per repository, `<branch>/` per branch) — the `<encoded-cwd>` mirrors Pi's own session-dir encoding, so the artifact dir and session dir share a name per repo. They are working files that survive context resets, never committed. Deleting a repository orphans its workflow dir — like Pi's own session folders, `/done` and `/abandon` are the cleanup paths.

## Conventions

- Keep prompt templates focused and single-purpose. Use frontmatter `description` for discoverability in autocomplete.
- Skills follow the Agent Skills standard. Include setup instructions if they need dependencies.
- Extensions should be self-contained single files unless they grow large enough to warrant a subdirectory with `index.ts`.

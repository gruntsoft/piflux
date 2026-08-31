---
description: Start a collaborative planning session for a new feature or change
argument-hint: "<description>"
---
You are starting a planning session. Your task is to collaboratively plan a change, then produce a structured plan file that a coding agent can implement in a separate session.

## Phase 1: Discovery

Get the current branch:

```bash
git branch --show-current
```

Check for a start artifact at `$WORKFLOW_DIR/<branch>/start.md`. If it does not exist, stop: "No start artifact found for branch `<branch>`. Run `/start <branch-name>` first to create the branch and start artifact."

Read the `## Metadata` section of the start artifact for the base branch. If it's missing, ask the human for the base branch before proceeding.

## Phase 2: Collaborative Planning

The user wants to accomplish: **$@**. If empty, ask them what they'd like to plan.

Engage the user in a structured conversation. Cover these topics in order:

1. **Why** — What problem does this solve? What's the motivation? What happens if we don't do it?
2. **Requirements** — What must the change do? What are the concrete acceptance criteria? What does "done" look like?
3. **Design decisions** — Explore approaches. Discuss tradeoffs. Which alternatives were considered and why were they rejected? What are the implications of the chosen approach?
4. **Implementation approach** — What files need to change? What's the logical sequence of changes? Are there dependencies between steps?
5. **Verification** — How do we confirm the change works? What test commands? What manual checks? What should the user observe?
6. **Guardrails** — What must NOT change? What constraints exist (API boundaries, performance budgets, compatibility)? What edge cases demand special care?
7. **Merge strategy** — how should `/ship` integrate the branch into the base: `squash` (fold all commits into one) or `merge` (preserve history with a `--no-ff` merge commit)?
8. **Delete remote branch** — should `/done` delete the remote feature branch after the merge (`true`), or keep it alive on the remote (`false`)?
9. **Version bump** — does this change bump the version? If so, what are the old and new versions? And — only when bumping — should `/ship` tag the release? Tagging is never automatic: it is an explicit decision made here, at planning time. Absent `Tag release` metadata means no tag.

**During this phase:**
- Actively look for blind spots, edge cases, and potential issues. Question assumptions gently but persistently.
- If the user reaches the conclusion the change isn't worth doing, say so openly. Abandoning a poorly-conceived change is a valid and valuable outcome.
- Keep the conversation moving toward concrete, specific decisions. Vague plans produce vague implementations.

## Phase 3: Produce the Plan File

When the user indicates the plan is complete (e.g., "looks good", "go ahead", "write it up", "I'm satisfied"), create `$WORKFLOW_DIR/<branch>/plan.md`.

Create the directory first if needed:

```bash
mkdir -p "$WORKFLOW_DIR/<branch>"
```

Capture the metadata you'll record in the plan file:
- **Base branch**: the base branch read from the start artifact (Phase 1).
- **Merge strategy**: `squash` or `merge` — the human's choice from Phase 2 item 7.
- **Delete remote branch**: `true` or `false` — the human's choice from Phase 2 item 8.
- **Old version / New version** (optional): the current and target versions — only when a version bump is part of the change (Phase 2 item 9).
- **Tag release** (optional): `true` or `false` — the human's choice from Phase 2 item 9, only when a version bump is declared. Absent field means no tag.

Write the plan file with this exact structure (the HTML comments are instructions for you — do NOT include them in the output):

```markdown
# <one-line goal>

## Why
<1-2 sentences of motivation>

## Requirements
- <concrete requirement>
- <concrete requirement>

## Design decisions
- <decision>: <rationale — why this over alternatives>
- <decision>: <rationale>

## Implementation
1. <file>: <what to change and how>
2. <file>: <what to change and how>

## Verification
- [ ] <concrete step — command to run, expected outcome>
- [ ] <manual check>

## Guardrails
- <file/function/pattern to preserve>
- <edge case to handle carefully>

## Open questions
- <anything ambiguous the coding agent should raise>

## Metadata
- Base branch: <branch the new branch was created from>
- Merge strategy: <squash | merge — how /ship integrates the branch into the base>
- Delete remote branch: <true | false — whether /done deletes the remote feature branch after the merge>
<!-- Old version and New version are optional — include them only when a version bump is part of the change. /ship creates the release tag from New version when Tag release is true, using the value verbatim (any prefix like `v` must be written into New version itself). -->
- Old version: <current version — only when this change bumps the version>
- New version: <new version — only when this change bumps the version>
<!-- Tag release is optional — include it only when a version bump is declared; tagging is never automatic. /ship creates and pushes the tag, /done never tags. Absence means no tag. -->
- Tag release: <true | false — only when this change bumps the version>
```

Every section must contain real, specific content. No placeholders like "TBD" or "add details here."

After writing the file, tell the user: "Plan written to `$WORKFLOW_DIR/<branch>/plan.md`. Start a fresh session with `/code` to implement."

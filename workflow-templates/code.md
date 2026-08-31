---
description: Implement changes from the plan file for the current branch
---
You are an implementation agent. Your task is to implement the changes described in the plan file for the current branch.

## Phase 1: Discovery

Get the current branch:

```bash
git branch --show-current
```

Determine the default branch:

```bash
git remote show origin | grep "HEAD branch" | cut -d: -f2 | xargs
```

If you are on the default branch (`main` or `master`), stop: "You are on the default branch. Implementation should happen on a feature branch. Run `/plan` first to create one."

Read the plan file at `$WORKFLOW_DIR/<branch>/plan.md`. If it does not exist, stop: "No plan file found for branch `<branch>`. Run `/plan` first to create one."

The plan file is **read-only**. Never modify it. If the plan is wrong, incomplete, or inconsistent with what you find, raise it with the user — they'll decide whether to proceed, adjust course, or return to planning.

Parse the plan file. Pay special attention to:
- **Implementation** — your primary guide. Follow it step by step, in order.
- **Guardrails** — hard constraints. Do not violate these.
- **Design decisions** — context for judgment calls. When the plan is ambiguous, these tell you which direction to lean.
- **Open questions** — raise these with the user before proceeding with the relevant implementation step.

If the plan is incomplete (missing sections, placeholders like "TBD"), flag the gaps to the user and do your best effort. Ask the user if a gap blocks you.

## Phase 2: Implementation

Before making any changes, run the existing test suite and note the results — this establishes the baseline. If the suite has pre-existing failures, flag them to the user and record them in the code file's `## Pre-existing test failures` section: they are not yours to fix, but `/review` and `/ireview` need them to tell pre-existing failures apart from regressions you introduce.

Work through the **Implementation** section sequentially:

1. For each step, make the described change.
2. Write unit tests for the changed code: methods, conditional branches, error scenarios, edge cases. Tests should be meaningful, but you may skip scenarios that are unreasonable to test. If the project has no test infrastructure, skip test creation entirely — do not set up a new framework.
3. Run the full test suite again and confirm your changes don't break it. Any failure that wasn't in the baseline is a regression — fix it before moving on.
4. If you encounter something the plan didn't cover, use the **Design decisions** to infer the right approach. If you still can't resolve it, ask the user — reference the specific part of the plan that's unclear.
5. If something in the plan seems wrong or problematic, distinguish major issues from minor deviations:
   - **Major** — the problem invalidates a Requirement or Design Decision (the plan asks for something impossible, self-contradictory, or clearly wrong). Raise it with the user. You are a partner, not a compiler. Say: "The plan says X, but I think Y might be an issue because Z. Should I proceed as planned or adjust?"
   - **Minor** — the intent still holds, but the plan's approach would introduce a bug or a better path exists. Document the deviation in the Plan deviations section of the code file and proceed.

## Phase 3: Verification

Run every step in the **Verification** section of the plan. Report results clearly. If something doesn't pass, fix it and re-verify.

## Phase 4: Write Code File

Create `$WORKFLOW_DIR/<branch>/` if it doesn't exist:

```bash
mkdir -p "$WORKFLOW_DIR/<branch>"
```

Write `$WORKFLOW_DIR/<branch>/code.md` (overwriting any existing file) with this structure:

```markdown
# Code session: <branch>

## Files changed
- <relative path of each file you created or modified>

## Pre-existing test failures
- <failures from the baseline run, or "None" if the suite was clean or the project has no tests>

## Unresolved issues
- [ ] <finding reference + why it was skipped>

## Plan deviations
- <what differed from the plan and why>
```

- **Files changed** — one bullet per file you touched, relative paths, no backticks. The review templates pipe this list to `git add`, so keep it exact.
- **Pre-existing test failures** — the failures found in the baseline run, or `None` if the suite was clean or no test infrastructure exists. `/review` and `/ireview` read this section to distinguish pre-existing failures from regressions.
- **Unresolved issues** — skipped review findings only, never plan deviations. Empty for a first implementation (no findings exist yet). It is only populated when an `/icode` session intentionally skips a review finding. For a first implementation, remove the placeholder line — the section stays empty with no bullets.
- **Plan deviations** — plain bullets (no checkboxes), one per intentional deviation from the plan: what differed and why. This is documentation, not a todo list. When rewriting the code file, carry forward any deviations that remain true and drop those that no longer apply.

After writing the code file, summarize what was implemented, confirm `$WORKFLOW_DIR/<branch>/code.md` was written with the full file list, and tell the user they can now run `/review` in a fresh session.

## Important principles

- The plan file is your sole source of truth. The planning conversation happened in a different session; you don't have access to it.
- The plan is a map, not a railroad. Walking the path may reveal pitfalls the map didn't show. If you need to deviate from the plan for a valid technical reason, document it in the Plan deviations section of the code file — don't silently diverge.
- Do not re-litigate design decisions from the plan unless you find a concrete problem.
- Do not make unrelated improvements or refactors unless the plan explicitly allows it.
- A clean, focused implementation that matches the plan is better than a sprawling one that "also fixes a few other things."
